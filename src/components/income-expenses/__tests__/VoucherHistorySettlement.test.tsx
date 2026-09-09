// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import VoucherHistoryDialog from "../VoucherHistoryDialog";

vi.mock("@/hooks/income-expenses/flexMutations", () => ({
  useVoucherCancellation: () => ({ data: null, isLoading: false }),
  useVoucherChangeLog: () => ({ data: [], isLoading: false, error: null }),
}));
vi.mock("@/hooks/useReservationSettlement", () => ({
  useReservationSettlementForVoucher: () => ({ data: {
    id: "10000000-0000-4000-8000-000000000001", sourceVoucherId: "10000000-0000-4000-8000-000000000002",
    depositAmount: 100, retainedAmount: 60, refundAmount: 40, refundedAmount: 40, refundRemaining: 0,
    refundState: "PAID", roomReleased: true, roomBlockers: [], revenueVoucherId: "10000000-0000-4000-8000-000000000003",
    offsetVoucherId: "10000000-0000-4000-8000-000000000004", refundVoucherId: "10000000-0000-4000-8000-000000000005",
    settlementDate: "2026-09-10", reasonCode: "OTHER", reasonText: "Khách chuyển nơi ở",
  } }),
  useReservationSettlementAudit: () => ({ data: { actorName: "Nguyễn Quản lý" } }),
}));
vi.mock("@/components/deposits/ReservationSettlementStatus", () => ({ ReservationSettlementStatus: () => <div>Đã hoàn</div> }));

afterEach(cleanup);
describe("VoucherHistoryDialog settlement history", () => {
  it("shows actor, reason, and navigable source and generated vouchers", () => {
    render(<MemoryRouter><VoucherHistoryDialog open onOpenChange={() => {}} voucher={{ id: "10000000-0000-4000-8000-000000000002", code: "PT-01" }} /></MemoryRouter>);
    expect(screen.getByText(/Nguyễn Quản lý/)).toBeTruthy();
    expect(screen.getByText(/Khách chuyển nơi ở/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Phiếu nhận ban đầu" }).getAttribute("href")).toContain("000000000002");
    expect(screen.getByRole("link", { name: "Phiếu hoàn tiền" }).getAttribute("href")).toContain("000000000005");
  });
});
