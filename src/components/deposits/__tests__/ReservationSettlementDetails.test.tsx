// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ReservationSettlementDetails } from "../ReservationSettlementDetails";

vi.mock("@/hooks/useReservationSettlement", () => ({ useReservationSettlementAudit: () => ({ data: { actorName: "Nguyễn Quản lý", settlementDate: "2026-09-10", reason_code: "OTHER", reason_text: "Khách đổi nơi ở" } }) }));
vi.mock("@/hooks/useReservationRefundEvidence", () => ({ useReservationRefundEvidence: () => ({ data: [{ id: "refund-1", code: "PC-01", voucher_date: "2026-09-10", approval_status: "APPROVED", posting_status: "POSTED", attachments: ["/proof.png"] }], isLoading: false }) }));
vi.mock("@/components/ui/storage-image", () => ({ StorageImage: ({ value, alt }: { value: string; alt: string }) => <img src={value} alt={alt} /> }));
vi.mock("@/components/ui/attachment-lightbox", () => ({ AttachmentLightbox: ({ index }: { index: number | null }) => index !== null ? <div>Ảnh phóng lớn</div> : null }));
afterEach(cleanup);
const settlement = { id: "s1", sourceVoucherId: "source-1", depositAmount: 3000000, retainedAmount: 1000000, refundAmount: 2000000, refundedAmount: 2000000, refundRemaining: 0, refundState: "PAID" as const, roomReleased: true, roomBlockers: [], revenueVoucherId: "revenue-1", offsetVoucherId: "offset-1", refundVoucherId: "refund-1" };
describe("direct settlement details", () => {
  it("shows the complete decision and clickable refund proof without opening history", () => {
    render(<MemoryRouter><ReservationSettlementDetails settlement={settlement} /></MemoryRouter>);
    expect(screen.getByText("Khách đã bỏ cọc")).toBeTruthy();
    expect(screen.getByText(/Nguyễn Quản lý/)).toBeTruthy();
    expect(screen.getByText(/Khách đổi nơi ở/)).toBeTruthy();
    expect(screen.getByText(/Giữ lại thành doanh thu/)).toBeTruthy();
    expect(screen.getByText(/Đã hoàn cho khách/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /PC-01/ }).getAttribute("href")).toContain("refund-1");
    fireEvent.click(screen.getByRole("button", { name: "Xem chứng từ hoàn tiền 1" }));
    expect(screen.getByText("Ảnh phóng lớn")).toBeTruthy();
  });
});
