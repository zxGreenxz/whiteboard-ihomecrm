// @vitest-environment jsdom
//
// Sổ cọc đầy đủ (desktop) với danh sách dài ở ba tab bảng: Đủ/Thiếu cọc,
// Hoàn/Bỏ cọc, Phiếu giữ chỗ. DOM chỉ chứa một cửa sổ dòng; các con số đếm và
// bộ lọc tìm kiếm vẫn chạy trên toàn bộ danh sách.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, Fragment, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demDongTrongBang, giaLapKichThuocKhungCuon } from "@/components/ui/__tests__/giaLapKichThuoc";
import type { HeldDepositRow, RefundForfeitRow } from "@/hooks/useDepositDashboard";
import type { ReservationDepositRow } from "@/hooks/useDeposits";

const fx = vi.hoisted(() => ({
  persisted: {} as Record<string, unknown>,
  held: [] as unknown[],
  refunds: [] as unknown[],
  reservations: [] as unknown[],
}));

// useReservationSettlement gọi `supabase.rpc.bind(supabase)` ngay lúc nạp module.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useCopilotPageContext", () => ({ useCopilotPageContext: () => {} }));
vi.mock("@/hooks/use-mobile", () => ({ usePhoneViewport: () => false, useIsMobile: () => false }));
vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement("a", { href: to }, children),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: <T,>(key: string, initial: T | (() => T)) =>
    useState<T>(
      key in fx.persisted
        ? (fx.persisted[key] as T)
        : typeof initial === "function"
          ? (initial as () => T)()
          : initial,
    ),
}));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock("@/lib/permissionPages", () => ({ canUse: () => true }));
vi.mock("@/hooks/income-expenses/statusMutations", () => ({
  useApproveVoucher: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useDepositDashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDepositDashboard")>()),
  useHeldDeposits: () => ({ data: fx.held, isLoading: false }),
  useDepositRefundsForfeits: () => ({ data: fx.refunds, isLoading: false }),
  useHeldDepositSummary: () => ({ data: [] }),
  useRefundForfeitSummary: () => ({ data: undefined }),
  useReservationDepositSettlementSummary: () => ({ data: undefined }),
}));
vi.mock("@/hooks/useDeposits", () => ({
  useReservationDeposits: () => ({ data: fx.reservations, isLoading: false }),
  useReservationDepositSummary: () => ({ data: undefined }),
}));
vi.mock("@/hooks/useReservationHoldDeadlines", () => ({ useReservationHoldDeadlines: () => ({ data: {} }) }));
vi.mock("@/components/buildings/BuildingFilterSelect", () => ({ BuildingFilterSelect: () => null }));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: () => null }));
vi.mock("@/components/deposits/CreateDepositDialog", () => ({ CreateDepositDialog: () => null }));
vi.mock("@/components/deposits/HoldDeadlineDialog", () => ({ HoldDeadlineDialog: () => null }));
vi.mock("@/components/contracts/ContractFormDialog", () => ({ ContractFormDialog: () => null }));
vi.mock("@/components/deposits/ReservationSettlementDialog", () => ({
  ReservationSettlementDialog: ({ open, voucherId }: { open: boolean; voucherId: string | null }) =>
    open ? <div data-testid="settlement-dialog">{voucherId}</div> : null,
}));
vi.mock("@/components/deposits/ReservationPendingRefundList", () => ({ ReservationPendingRefundList: () => null }));

const { default: DepositsPage } = await import("../DepositsPage");

function hdThieuCoc(i: number): HeldDepositRow {
  return {
    contract_id: `hd-${i}`,
    contract_number: `HD${i}`,
    building_id: "b1",
    building_name: "Toà A",
    room_name: `P.${i}`,
    customer_name: `Khách ${i}`,
    total_deposit: 5_000_000,
    deposit_paid: 2_000_000,
    deposit_remaining: 3_000_000,
    deposit_debt_mode: null,
    deposit_topup_due_date: null,
    state: "SHORT",
  };
}

function hoanCoc(i: number): RefundForfeitRow {
  return {
    id: `tl-${i}`,
    contract_id: `hd-${i}`,
    contract_number: `HD${i}`,
    building_id: "b1",
    building_name: "Toà A",
    room_name: `P.${i}`,
    customer_name: `Khách ${i}`,
    termination_date: "2026-09-01",
    termination_type: "NORMAL",
    kind: i % 2 === 0 ? "REFUND" : "FORFEIT",
    total_deposit: 5_000_000,
    total_deductions: 1_000_000,
    settlement_net: 4_000_000,
    status: "COMPLETED",
    posted_refund: 4_000_000,
    posted_refund_count: 1,
    posted_refund_codes: [`PC${i}`],
    refund_done: true,
    refund_drift: 0,
  };
}

function giuCho(i: number): ReservationDepositRow {
  return {
    id: `gc-${i}`,
    code: `PT${String(i).padStart(4, "0")}`,
    name: `Cọc giữ chỗ ${i}`,
    payer_name: `Khách ${i}`,
    total_amount: 1_000_000,
    voucher_date: "2026-09-01",
    approval_status: "APPROVED",
    building_id: "b1",
    building_name: "Toà A",
    room_id: `p-${i}`,
    room_name: `P.${i}`,
    settlement_status: "UNSETTLED",
    settlement: null,
  };
}

giaLapKichThuocKhungCuon();
beforeEach(() => {
  fx.held = [];
  fx.refunds = [];
  fx.reservations = [];
  fx.persisted = { "flt:deposits:view": "ledger" };
});
afterEach(() => cleanup());

describe("DepositsPage · sổ cọc đầy đủ với danh sách dài", () => {
  it("tab Đủ/Thiếu cọc: 500 HĐ → DOM chỉ chứa một cửa sổ dòng, số đếm vẫn là 500", () => {
    fx.persisted["flt:deposits:tab"] = "rooms";
    fx.held = Array.from({ length: 500 }, (_, i) => hdThieuCoc(i));
    const { container } = render(<DepositsPage />);
    const soDong = demDongTrongBang(container);
    // eslint-disable-next-line no-console
    console.log(`[đo DOM] DepositsPage tab rooms 500 HĐ → ${soDong} <tr> trong tbody`);
    expect(soDong, `tbody đang chứa ${soDong} dòng`).toBeLessThan(50);
    expect(soDong).toBeGreaterThan(0);
    expect(screen.getByText(/500 hợp đồng còn thiếu cọc/)).toBeTruthy();
  });

  it("tab Hoàn/Bỏ cọc: 500 hồ sơ → DOM chỉ chứa một cửa sổ dòng", () => {
    fx.persisted["flt:deposits:tab"] = "refunds";
    fx.refunds = Array.from({ length: 500 }, (_, i) => hoanCoc(i));
    const { container } = render(<DepositsPage />);
    const soDong = demDongTrongBang(container);
    // eslint-disable-next-line no-console
    console.log(`[đo DOM] DepositsPage tab refunds 500 hồ sơ → ${soDong} <tr> trong tbody`);
    expect(soDong, `tbody đang chứa ${soDong} dòng`).toBeLessThan(50);
    expect(soDong).toBeGreaterThan(0);
  });

  it("tab Phiếu giữ chỗ: 500 phiếu → cửa sổ dòng nhỏ; thẻ đếm và tìm kiếm chạy trên cả 500", () => {
    fx.persisted["flt:deposits:tab"] = "holds";
    fx.reservations = Array.from({ length: 500 }, (_, i) => giuCho(i));
    const { container } = render(<DepositsPage />);
    const soDong = demDongTrongBang(container);
    // eslint-disable-next-line no-console
    console.log(`[đo DOM] DepositsPage tab holds 500 phiếu → ${soDong} <tr> trong tbody`);
    expect(soDong, `tbody đang chứa ${soDong} dòng`).toBeLessThan(50);
    // Thẻ "Đang giữ chỗ" đếm toàn bộ 500 phiếu APPROVED.
    expect(screen.getByText("500")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Tìm mã, nội dung/), { target: { value: "PT049" } });
    // PT0490..PT0499 → 10 phiếu, dưới ngưỡng ảo hoá → render đủ 10 dòng.
    expect(demDongTrongBang(container)).toBe(10);
    expect(screen.getAllByText(/^PT049\d$/)).toHaveLength(10);
  });

  it("tab Phiếu giữ chỗ: nút Xử lý bỏ cọc mở dialog đúng phiếu", () => {
    fx.persisted["flt:deposits:tab"] = "holds";
    fx.reservations = Array.from({ length: 500 }, (_, i) => giuCho(i));
    render(<DepositsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Xử lý bỏ cọc" })[1]!);
    expect(screen.getByTestId("settlement-dialog").textContent).toBe("gc-1");
  });
});
