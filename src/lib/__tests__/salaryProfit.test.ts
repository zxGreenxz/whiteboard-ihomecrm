// D2.10 — phần lợi nhuận trong bảng lương theo sổ tổng (hàm thuần, lib/salaryProfit.ts).
// Số liệu là số mẫu, không phải số production.
import { describe, expect, it } from "vitest";
import { salCalc, type SalManager } from "@/lib/managerSalary";
import type { SalaryFreezeResult, SalaryProfitStaff, SalaryQuoteResult } from "@/lib/profitLedger/salaryReaders";
import { selfSummaryOf } from "@/lib/salarySelfSummary";
import {
  SalaryProfitStopError, fullInvestmentSelection, investmentByFromProfit, investmentPayState, profitOffsetFor,
  salaryFreezePlanFor, salaryFreezeProblem, salaryProfitFailure, salaryProfitPayoutBlock, salaryProfitQuoteFor,
  salaryQuoteProblem, salaryVoucherTotal, withSalaryProfit,
} from "@/lib/salaryProfit";

function staff(over: Partial<SalaryProfitStaff> = {}): SalaryProfitStaff {
  return {
    staff_id: "s1", organization_id: "org-1", shareholder_id: "sh-1", sheet_status: "DRAFT", profit_draft: false,
    allocations: [
      { building_id: "b1", building_label: "T1", amount: 3_000_000, status: "LOCKED", is_stale: false },
      { building_id: "b2", building_label: "T2", amount: 900_000, status: "DRAFT", is_stale: false },
    ],
    by_building: [{ label: "T1", building_ids: ["b1"], allocated: 3_000_000, override_amount: null, amount: 3_000_000 }],
    allocated_total: 3_000_000, investment_month: 3_000_000, investment_cap: 3_000_000,
    marker_through: null, settled_by_marker: false, settlement: null, paid_lines: [],
    paid_investment: 0, paid_offset: 0, advance_open: 0, advance_offset_month: 0, suggested_advance_offset: 0,
    remaining_offset: 0, offset_conflict: false, needs_review: { count: 0, suggested: 0 },
    ...over,
  };
}

const NEUTRAL: Partial<SalaryProfitStaff> = {
  shareholder_id: null, allocations: [], by_building: [], allocated_total: 0, investment_month: 0, investment_cap: 0,
};

function mgr(over: Partial<SalManager> = {}): SalManager {
  return {
    id: "s1", name: "Nhân viên A", short: "A", alias: "", role: "Quản lý", initials: "A", tone: "primary",
    workdays: 20, base: 5_000_000, roomRent: 1_000_000, incomeGoal: 0, bonusAuto: [], adjustments: [],
    investment: 3_000_000, investmentBy: [{ b: "T1", amount: 3_000_000 }], investmentLocked: true,
    commission: 0, commissionItems: [], commissionFlagged: [],
    advance: 500_000, advanceItems: [{ date: "05/10", label: "Ứng lương", amount: 500_000 }],
    roomRentItems: [], roomRentInvoice: null, paid: 0,
    stats: { jobs: 0, repairs: 0, afterHour: 0, workdays: 20, streak: 0 }, trend: [],
    status: "DRAFT", salaryMonthlyId: null, ledger: [],
    ...over,
  };
}

/** Như hook: phần sổ tổng gắn trước salCalc (kỳ chưa chốt). */
function draft(m: SalManager, s: SalaryProfitStaff | null): SalManager {
  const out = withSalaryProfit(m, s);
  out.calc = salCalc(out);
  return out;
}

/** Bảng đã chốt: calc lấy số đóng băng (như hook đọc salary_monthly). */
function locked(over: Partial<SalManager>, frozen: NonNullable<SalManager["frozen"]>, takehome: number, s: SalaryProfitStaff): SalManager {
  const m: SalManager = mgr({ ...over, status: "LOCKED", frozen });
  const out = withSalaryProfit(m, s);
  out.calc = { autoSum: 0, adjSum: 0, bonus: 0, gross: frozen.base + frozen.investment + frozen.commission, takehome };
  return out;
}

describe("đọc phần đầu tư từ máy chủ (E12)", () => {
  it("chỉ lấy toà đã chốt lợi nhuận, nhãn toà do máy chủ đặt", () => {
    expect(investmentByFromProfit(staff())).toEqual([{ b: "T1", amount: 3_000_000 }]);
    expect(investmentByFromProfit(null)).toEqual([]);
  });
});

describe("hồi quy — nhân viên không phải cổ đông", () => {
  it("không đổi ứng, khoản trừ, thực nhận; không có phần sổ tổng", () => {
    const before = mgr({ investment: 0, investmentBy: [] });
    const after = draft(before, staff(NEUTRAL));
    expect(after.profit).toBeNull();
    expect(after.advance).toBe(before.advance);
    expect(after.advanceItems).toEqual(before.advanceItems);
    expect(after.calc).toEqual(salCalc(before));
    expect(salaryProfitQuoteFor(after)).toBeNull();
    expect(salaryFreezePlanFor(after)).toBeNull();
    expect(salaryProfitPayoutBlock(after)).toBeNull();
    expect(investmentPayState(after)).toBeNull();
  });
});

describe("trừ tạm ứng lợi nhuận (D) — chỉ trong phần lợi nhuận đầu tư của tháng", () => {
  const withD = staff({ advance_open: 5_000_000, advance_offset_month: 1_200_000, suggested_advance_offset: 1_200_000 });

  it("thực nhận giảm đúng D, tổng lương giữ nguyên, có dòng 'Trừ tạm ứng lợi nhuận' trong ứng", () => {
    const base = mgr();
    const m = draft(base, withD);
    expect(m.calc!.gross).toBe(salCalc(base).gross);
    expect(m.calc!.takehome).toBe(salCalc(base).takehome - 1_200_000);
    expect(m.advance).toBe(500_000 + 1_200_000); // ⇒ advances_total khi chốt gồm D
    expect(m.advanceItems[m.advanceItems.length - 1]).toMatchObject({ kind: "PROFIT_ADVANCE", amount: 1_200_000, label: "Trừ tạm ứng lợi nhuận" });
    expect(m.profit).toMatchObject({ advanceOffset: 1_200_000, markerPaid: 0, relockForMarker: false });
  });

  it("D không bao giờ nhỏ hơn phần đã trừ ở phiếu trước", () => {
    const m = draft(mgr(), staff({ paid_offset: 700_000, suggested_advance_offset: 300_000, advance_offset_month: 300_000 }));
    expect(m.profit!.advanceOffset).toBe(700_000);
  });

  it("D = 0 không thêm dòng, không đổi ứng", () => {
    const m = draft(mgr(), staff());
    expect(m.advance).toBe(500_000);
    expect(m.advanceItems.some((a) => a.kind === "PROFIT_ADVANCE")).toBe(false);
  });

  it("bỏ chọn phần đầu tư thì không lấy lương cơ bản trừ tạm ứng", () => {
    const m = draft(mgr(), withD);
    expect(profitOffsetFor(m, fullInvestmentSelection(m))).toBe(1_200_000);
    expect(profitOffsetFor(m, 0)).toBe(0);
    expect(profitOffsetFor(m, 800_000)).toBe(800_000);
    expect(profitOffsetFor(m, -100_000)).toBe(0);
    // Phần đã trừ ở phiếu trước không lùi lại được (số gửi máy chủ là luỹ kế).
    const after = draft(mgr(), staff({ advance_offset_month: 1_200_000, suggested_advance_offset: 1_200_000, paid_offset: 500_000 }));
    expect(profitOffsetFor(after, 0)).toBe(500_000);
  });

  it("báo giá luỹ kế: chọn đủ ⇒ Y + D; chọn một phần ⇒ D theo phần chọn; bỏ nhiễu số thực", () => {
    const m = draft(mgr(), withD);
    expect(salaryProfitQuoteFor(m)).toEqual({ investmentSelected: 3_000_000, offsetSelected: 1_200_000 });
    expect(salaryProfitQuoteFor(m, { investmentSelected: 0 })).toEqual({ investmentSelected: 0, offsetSelected: 0 });
    const noisy = draft(mgr({ investment: 0.1 + 0.2, investmentBy: [{ b: "T1", amount: 0.1 + 0.2 }] }), staff({ investment_month: 0.3 }));
    expect(salaryProfitQuoteFor(noisy)!.investmentSelected).toBe(0.3);
  });

  it("đóng băng trước khi chốt: Y đang hiện, D đang trừ, ĐÚNG thực nhận sẽ chốt", () => {
    const m = draft(mgr(), withD);
    expect(salaryFreezePlanFor(m)).toEqual({ expectedInvestment: 3_000_000, maxOffset: 1_200_000, expectedTakeHome: m.calc!.takehome });
  });
});

describe("tháng nằm trong mốc 'đã trả đủ'", () => {
  const settled = staff({ settled_by_marker: true, marker_through: "2026-09-01", investment_cap: 0 });

  it("bảng nháp: tổng lương giữ nguyên, tiền nhận giảm đúng phần đầu tư; không trừ tạm ứng; báo giá 0/0", () => {
    const base = mgr();
    const m = draft(base, settled);
    expect(m.calc!.gross).toBe(salCalc(base).gross);
    expect(m.calc!.takehome).toBe(salCalc(base).takehome - 3_000_000);
    expect(m.advanceItems[m.advanceItems.length - 1]).toMatchObject({ kind: "PROFIT_MARKER", amount: 3_000_000 });
    expect(m.profit).toMatchObject({ markerPaid: 3_000_000, advanceOffset: 0 });
    expect(salaryProfitQuoteFor(m)).toEqual({ investmentSelected: 0, offsetSelected: 0 });
    expect(investmentPayState(m)).toEqual({ kind: "MARKER", through: "2026-09-01" });
  });

  it("đầu tư âm/bằng 0 không thành khoản cộng lại", () => {
    const m = draft(mgr({ investment: -400_000, investmentBy: [{ b: "T1", amount: -400_000 }] }), settled);
    expect(m.profit!.markerPaid).toBe(0);
    expect(m.calc!.takehome).toBe(salCalc(mgr({ investment: -400_000 })).takehome);
  });

  it("bảng đã chốt qua màn mới (bản đóng băng khớp, số ứng đã chốt có phần đã trả theo mốc) ⇒ trả được", () => {
    const fz = { base: 5_000_000, investment: 3_000_000, commission: 0, advance: 500_000 + 3_000_000 };
    const m = locked({}, fz, 5_000_000 + 3_000_000 - 3_500_000 - 1_000_000,
      staff({ ...settled, sheet_status: "LOCKED", settlement: { id: "c3", investment_month: 3_000_000, advance_offset_month: 0, applied_offset_at_freeze: 0, expected_take_home: 3_500_000, created_at: "2026-10-05T00:00:00Z", matches_sheet: true } }));
    expect(m.profit).toMatchObject({ markerPaid: 3_000_000, relockForMarker: false });
    expect(salaryProfitPayoutBlock(m)).toBeNull();
    expect(salaryProfitQuoteFor(m)).toEqual({ investmentSelected: 0, offsetSelected: 0 });
    const s = selfSummaryOf(m);
    expect(s).toMatchObject({ advance: 500_000, markerPaid: 3_000_000, paidOut: 0 });
  });

  it("bảng chốt trước mốc (không có bản đóng băng khớp) ⇒ chặn trả, phải chốt lại", () => {
    const fz = { base: 5_000_000, investment: 3_000_000, commission: 0, advance: 500_000 };
    const m = locked({}, fz, 6_500_000, staff({ ...settled, sheet_status: "LOCKED" }));
    expect(m.profit).toMatchObject({ markerPaid: 0, relockForMarker: true });
    expect(salaryProfitPayoutBlock(m)).toMatch(/chốt lại/);
    expect(() => salaryProfitQuoteFor(m)).toThrow(SalaryProfitStopError);
  });

  it("bản đóng băng khớp nhưng số ứng đã chốt không có chỗ cho phần đầu tư ⇒ vẫn chặn (chốt khi chưa có mốc)", () => {
    const fz = { base: 5_000_000, investment: 3_000_000, commission: 0, advance: 500_000 };
    const m = locked({}, fz, 6_500_000, staff({ ...settled, sheet_status: "LOCKED", settlement: { id: "c3", investment_month: 3_000_000, advance_offset_month: 0, applied_offset_at_freeze: 0, expected_take_home: 6_500_000, created_at: "2026-10-05T00:00:00Z", matches_sheet: true } }));
    expect(m.profit!.relockForMarker).toBe(true);
  });
});

describe("bảng lương đã chốt", () => {
  const lockedStaff = staff({ sheet_status: "LOCKED", advance_offset_month: 1_200_000, suggested_advance_offset: 1_200_000, paid_investment: 1_000_000, paid_offset: 400_000 });
  const fz = { base: 5_000_000, investment: 3_000_000, commission: 0, advance: 500_000 + 1_200_000 };

  it("báo giá Y_m và D của bảng cho mọi lần trả; dòng D khớp số ứng đã chốt", () => {
    const m = locked({}, fz, 5_300_000, lockedStaff);
    expect(salaryProfitQuoteFor(m)).toEqual({ investmentSelected: 3_000_000, offsetSelected: 1_200_000 });
    expect(m.advance).toBe(fz.advance);
    expect(salaryFreezePlanFor(m)).toBeNull();
    const s = selfSummaryOf(m);
    expect(s).toMatchObject({ advance: 500_000, profitOffset: 1_200_000, markerPaid: 0 });
    expect(s.gross - s.deductTotal).toBe(m.calc!.takehome);
  });

  it("bảng chốt chưa gồm phần trừ đã trừ ở phiếu trước ⇒ chặn trả", () => {
    const m = locked({}, fz, 5_300_000, { ...lockedStaff, offset_conflict: true });
    expect(salaryProfitPayoutBlock(m)).toMatch(/Mở chốt lương rồi chốt lại/);
    expect(() => salaryProfitQuoteFor(m)).toThrow(SalaryProfitStopError);
  });
});

describe("kiểm biên nhận E13/E15", () => {
  const m = draft(mgr(), staff({ advance_offset_month: 1_200_000, suggested_advance_offset: 1_200_000 }));
  const plan = salaryFreezePlanFor(m)!;
  const common = {
    shareholder_id: "sh-1", staff_id: "s1", period_month: "2026-10-01", organization_id: "org-1",
    investment_month: 3_000_000, advance_offset_month: 1_200_000, paid_investment: 0, paid_offset: 0,
    unpaid_investment: 3_000_000, settled_by_marker: false,
  };
  const frozen = (over: Partial<typeof common> = {}): SalaryFreezeResult => ({
    kind: "FROZEN", settlement_id: "c3", voided_settlement_id: null, ...common, ...over,
  });

  it("đóng băng khớp ⇒ chốt tiếp; lệch D / Y / mốc / đã chốt ở nơi khác ⇒ dừng và tải lại", () => {
    expect(salaryFreezeProblem(m, plan, frozen())).toBeNull();
    for (const bad of [frozen({ advance_offset_month: 900_000 }), frozen({ investment_month: 2_000_000 }), frozen({ settled_by_marker: true })]) {
      const problem = salaryFreezeProblem(m, plan, bad);
      expect(problem).toBeInstanceOf(SalaryProfitStopError);
      expect(problem).toMatchObject({ outcome: "failure", reload: true });
    }
    const already = salaryFreezeProblem(m, plan, { kind: "ALREADY_LOCKED", settlement_id: null, offset_conflict: false, ...common });
    expect(already?.message).toMatch(/vừa được chốt ở nơi khác/);
    expect(salaryFreezeProblem(m, plan, { kind: "NOT_SHAREHOLDER", staff_id: "s1", period_month: "2026-10-01", organization_id: "org-1" })).toBeInstanceOf(SalaryProfitStopError);
  });

  it("báo giá báo trước 'cần chủ xem lại' ⇒ dừng, có lý do", () => {
    const quoted = (reason: string | null): SalaryQuoteResult => ({
      kind: "QUOTED", quote_id: "q1", shareholder_id: "sh-1", staff_id: "s1", period_month: "2026-10-01", organization_id: "org-1",
      investment_amount: 3_000_000, advance_offset_amount: 1_200_000, investment_month: 3_000_000, advance_offset_month: 1_200_000,
      paid_investment: 0, paid_offset: 0, settled_by_marker: false, sheet_status: "DRAFT", expected_voucher_amount: 1,
      payout_request_key: "k", expires_at: "2026-10-05T00:30:00Z", voided_quote_ids: [], offset_conflict: false, needs_review_reason: reason,
    });
    expect(salaryQuoteProblem(quoted(null), "A")).toBeNull();
    expect(salaryQuoteProblem(quoted("OFFSET_CONFLICT"), "A")?.message).toMatch(/chốt lại/);
    expect(salaryQuoteProblem(quoted("MIXED_SIGN_SELECTION"), "A")?.message).toMatch(/ngược chiều/);
    expect(salaryQuoteProblem({ kind: "NOT_SHAREHOLDER", staff_id: "s1", period_month: "2026-10-01", organization_id: null }, "A")).toBeInstanceOf(SalaryProfitStopError);
  });

  it("lỗi máy chủ ⇒ câu tiếng Việt theo mã, từ chối chắc chắn (chưa lập phiếu)", () => {
    const changed = salaryProfitFailure({ code: "PT409", message: "SALARY_PROFIT_QUOTE_CHANGED: x", details: null }, "salary_quote", "A");
    expect(changed).toMatchObject({ outcome: "failure", reload: true, completed: [] });
    expect(changed.message).toMatch(/vừa đổi/);
    const marker = salaryProfitFailure({ code: "22023", message: "SALARY_PROFIT_SETTLED_BY_MARKER: x", details: '{"marker_through":"2026-09-01"}' }, "salary_quote", "A");
    expect(marker.message).toContain("09/2026");
    const denied = salaryProfitFailure({ code: "42501", message: "SALARY_PROFIT_DENIED: x" }, "salary_freeze", "A");
    expect(denied.message).toMatch(/không có quyền/);
    const offline = salaryProfitFailure(new TypeError("Failed to fetch"), "salary_quote", "A");
    expect(offline).toMatchObject({ outcome: "failure" });
    expect(offline.message).toMatch(/chưa lập phiếu lương/);
  });
});

it("tổng phiếu lương báo trước = thực nhận + tiền phòng kẹp theo nợ còn", () => {
  expect(salaryVoucherTotal(4_000_000, null)).toBe(4_000_000);
  expect(salaryVoucherTotal(4_000_000, { amount: 1_000_000, remaining: 1_000_000 })).toBe(5_000_000);
  expect(salaryVoucherTotal(4_000_000, { amount: 1_000_000, remaining: 300_000 })).toBe(4_300_000);
  expect(salaryVoucherTotal(4_000_000, { amount: 1_000_000, remaining: 0 })).toBe(4_000_000);
  expect(salaryVoucherTotal(4_000_000, { amount: 1_000_000 })).toBe(5_000_000);
});

it("nhãn trả phần đầu tư: đã trả qua phiếu / một phần / cần chủ xem lại / chưa trả", () => {
  const line = (state: "LINKED" | "NEEDS_REVIEW", code: string, live = true) => ({
    line_id: code, salary_voucher_id: "v-" + code, voucher_code: code, voucher_amount: 1, voucher_live: live,
    investment: 1, advance_offset: 0, suggested_investment: null, state, source: "UI_QUOTE", created_at: "2026-10-05T00:00:00Z", linked_at: null,
  });
  expect(investmentPayState(draft(mgr(), staff({ paid_lines: [line("LINKED", "PC1")], paid_investment: 3_000_000 })))).toMatchObject({ kind: "PAID", codes: ["PC1"] });
  expect(investmentPayState(draft(mgr(), staff({ paid_lines: [line("LINKED", "PC1")], paid_investment: 1_000_000 })))).toMatchObject({ kind: "PARTIAL", paid: 1_000_000 });
  expect(investmentPayState(draft(mgr(), staff({ paid_lines: [line("LINKED", "PC1"), line("NEEDS_REVIEW", "PC2")], paid_investment: 1 })))).toMatchObject({ kind: "REVIEW", codes: ["PC2"] });
  expect(investmentPayState(draft(mgr(), staff({ paid_lines: [line("NEEDS_REVIEW", "PC3", false)] })))).toEqual({ kind: "UNPAID" });
});
