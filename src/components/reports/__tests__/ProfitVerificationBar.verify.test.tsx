// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { it, expect, vi, afterEach, describe } from "vitest";
import type { ProfitVerificationData } from "@/hooks/useProfitVerification";

const m = vi.hoisted(() => ({
  data: undefined as unknown,
  lastOpts: undefined as unknown,
}));

vi.mock("@/hooks/useProfitVerification", () => ({
  useProfitVerification: (opts: unknown) => {
    m.lastOpts = opts;
    return {
      data: m.data,
      status: "success",
      fetchStatus: "idle",
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

import { ProfitVerificationBar } from "../ProfitVerificationBar";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseData: ProfitVerificationData = {
  draftCount: 0,
  draftTotal: 0,
  nonKqkdIncome: 0,
  nonKqkdExpense: 0,
  noBookCount: 0,
  noBookTotal: 0,
  noBookIncome: 0,
  noBookExpense: 0,
  fa: null,
  invoicePaid: null,
  cancelled: null,
};

const baseProps = {
  ym: "2026-09",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  monthLabel: "9",
  accrualMode: true,
  pnlOnly: true,
  totalIncome: 1000,
  totalExpense: 400,
  shownIncomeSum: 1000,
  shownExpenseSum: 400,
  hiddenCount: 0,
  hiddenIncomeSum: 0,
  hiddenExpenseSum: 0,
};

const engine = (income: number, expense: number, extra: [string, { name: string; income: number; expense: number }][] = []) => ({
  income,
  expense,
  byBuilding: new Map([["b1", { name: "Toà A", income, expense }], ...extra]),
});

describe("ProfitVerificationBar", () => {
  it("F12: chưa có số engine ⇒ WARNING, không hiện khớp", () => {
    m.data = { ...baseData };
    const states: string[] = [];
    render(<ProfitVerificationBar {...baseProps} accrualMode={false} onStateChange={(s) => states.push(s)} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Chưa đối chiếu engine");
    expect(text).not.toContain("Khớp engine");
    expect(states.at(-1)).toBe("WARNING");
  });

  it("F12: khớp engine ⇒ OK, nhãn nói rõ phần đã duyệt, không chữ LỆCH/≠/UNAVAILABLE", () => {
    m.data = { ...baseData, fa: engine(1000, 400) };
    const states: string[] = [];
    render(<ProfitVerificationBar {...baseProps} onStateChange={(s) => states.push(s)} />);
    const btn = screen.getByRole("button", { name: /Kiểm chứng T9/ });
    expect(btn.textContent).toContain("Thu = Σ dòng ✓");
    expect(btn.textContent).toContain("Chi = Σ dòng ✓");
    expect(btn.textContent).toContain("Khớp engine (phần đã duyệt)");
    expect(btn.textContent).not.toMatch(/UNAVAILABLE|LỆCH|≠/);
    expect(states.at(-1)).toBe("OK");
  });

  it("F12: cảnh báo ngoài thanh đẩy OK lên WARNING", () => {
    m.data = { ...baseData, fa: engine(1000, 400) };
    const states: string[] = [];
    render(
      <ProfitVerificationBar
        {...baseProps}
        extraWarnings={["Thiếu chi cố định toà A"]}
        onStateChange={(s) => states.push(s)}
      />,
    );
    expect(states.at(-1)).toBe("WARNING");
    expect(document.body.textContent).toContain("Thiếu chi cố định toà A");
  });

  it("F34: ngoài-KQKD nêu cơ sở, giữ số âm, dồn tích ghi chú tham khảo", () => {
    m.data = { ...baseData, fa: engine(1000, 400), nonKqkdIncome: -5000, nonKqkdExpense: 0 };
    render(<ProfitVerificationBar {...baseProps} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("theo ngày phiếu, đã duyệt");
    expect(text).toMatch(/thu -5\.000 đ/);
    expect(text).toContain("tham khảo");
    expect(text).toContain("Số âm");
  });

  it("F35: lệch engine chỉ liệt kê đúng toà lệch kèm số chênh", () => {
    m.data = {
      ...baseData,
      fa: engine(900, 400, [["b2", { name: "Toà B", income: 100, expense: 0 }]]),
    };
    // Trang: b1 thu 1000 (engine 900 ⇒ lệch +100); b2 khớp 100.
    // totalIncome = 1100 để tổng cũng lệch tổng engine (1000).
    render(
      <ProfitVerificationBar
        {...baseProps}
        totalIncome={1100}
        shownIncomeSum={1100}
        accrualRows={[
          { buildingId: "b1", buildingName: "Toà A", income: 1000, expense: 0, approvalStatus: "APPROVED" },
          { buildingId: "b2", buildingName: "Toà B", income: 100, expense: 0, approvalStatus: "APPROVED" },
          { buildingId: "b1", buildingName: "Toà A", income: 0, expense: 400, approvalStatus: "APPROVED" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Kiểm chứng T9/ }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Lệch theo toà");
    expect(text).toContain("Toà A (thu 100 đ / chi 0 đ)");
    expect(text).not.toContain("Toà B (");
  });

  it("F48: lọc chỉ khoản thu — chi không bị báo lệch, hook nhận voucherType", () => {
    m.data = { ...baseData, fa: engine(1000, 9999) };
    const states: string[] = [];
    render(
      <ProfitVerificationBar
        {...baseProps}
        voucherType="INCOME"
        totalExpense={0}
        shownExpenseSum={0}
        onStateChange={(s) => states.push(s)}
      />,
    );
    expect((m.lastOpts as { voucherType: string }).voucherType).toBe("INCOME");
    const btn = screen.getByRole("button", { name: /Kiểm chứng T9/ });
    expect(btn.textContent).not.toMatch(/LỆCH|≠/);
    expect(btn.textContent).toContain("Chi: không so");
    expect(states.at(-1)).toBe("OK");
  });

  it("F06: engine vẫn tính khoản phát sinh sau chốt ⇒ trừ đúng phần đó thì khớp (cả theo toà); không trừ thì LỆCH", () => {
    // Trang đã bỏ 300 thu + 50 chi của tháng đã chốt; engine (fa_*) vẫn có.
    m.data = { ...baseData, fa: engine(1300, 450) };
    const ex = {
      count: 2,
      income: 300,
      expense: 50,
      byBuilding: new Map([["b1", { income: 300, expense: 50 }]]),
    };
    const states: string[] = [];
    render(
      <ProfitVerificationBar
        {...baseProps}
        accrualRows={[{ buildingId: "b1", buildingName: "Toà A", income: 1000, expense: 400 }]}
        engineExclusions={ex}
        extraWarnings={["2 khoản phát sinh sau chốt chưa cộng"]}
        onStateChange={(s) => states.push(s)}
      />,
    );
    const btn = screen.getByRole("button", { name: /Kiểm chứng T9/ });
    expect(btn.textContent).toContain("Khớp engine");
    expect(document.body.textContent).toContain("Đối chiếu engine đã trừ:");
    expect(document.body.textContent).toMatch(/2 khoản phát sinh sau chốt \(thu 300 đ · chi 50 đ\)/);
    // có khoản sau chốt ⇒ "cần xem lại", không xanh
    expect(states.at(-1)).toBe("WARNING");
    cleanup();

    const states2: string[] = [];
    render(<ProfitVerificationBar {...baseProps} onStateChange={(s) => states2.push(s)} />);
    expect(screen.getByRole("button", { name: /Kiểm chứng T9/ }).textContent).toMatch(/LỆCH engine/);
    expect(states2.at(-1)).toBe("ERROR");
  });

  it("F36: hiện dòng phiếu đã huỷ trong kỳ khi có", () => {
    m.data = { ...baseData, fa: engine(1000, 400), cancelled: { income: 2000, expense: 300 } };
    render(<ProfitVerificationBar {...baseProps} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Đã huỷ trong kỳ (theo ngày phiếu");
    expect(text).toMatch(/thu 2\.000 đ · chi 300 đ/);
  });
});
