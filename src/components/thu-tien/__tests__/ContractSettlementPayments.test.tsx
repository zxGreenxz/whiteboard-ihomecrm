// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractSettlementPayments } from "../ContractSettlementPayments";
import type { SettlementRow, SettlementSourceRow, SettlementVoucherRow, VoucherSnapshot } from "@/lib/contractSettlement";

const source: SettlementSourceRow = {
  rowType: "source", rowKey: "broker:contract-a", settlementKind: "commission",
  sourceRef: { kind: "broker", organizationId: "org", contractId: "contract-a" },
  organizationId: "org", buildingId: "building", roomId: "room", roomName: "101",
  contractId: "contract-a", contractNumber: "HD-101", customerName: "Nguyễn Ánh",
  eventDate: "2026-08-10", recipient: { name: "Sale A", bankName: null, bankAccount: null },
  basis: { kind: "COMMISSION", status: "AVAILABLE", amount: 2_000_000, measuredAt: null, source: "tier", fingerprint: null, version: null, warning: null },
  createEligibility: { state: "ready", allowed: true, reasonCodes: [] },
};
function voucher(id: string, patch: Partial<VoucherSnapshot> = {}): SettlementVoucherRow {
  return {
    rowType: "voucher", rowKey: `voucher:${id}`, voucherId: id, voucherCode: `PC-${id}`,
    settlementKind: "commission", sourceLink: { state: "verified", sourceRef: source.sourceRef }, basis: source.basis,
    snapshot: { state: "ready", value: {
      id, code: `PC-${id}`, organizationId: "org", buildingId: "building", roomId: "room", roomName: "102",
      contractId: "contract-a", contractNumber: "HD-102", tenantId: null, customerName: "Khách B",
      totalAmount: 2_000_000, type: "EXPENSE", payerName: "Môi giới B", receiveBankName: "ACB", receiveBankAccount: "123456",
      accountId: null, approvalStatus: "UNAPPROVED", postingStatus: "UNPOSTED", postingMode: "CASHBOOK",
      reviewState: "PENDING", reviewReason: null, approvalVersion: 1, postingVersion: 1, reviewVersion: 1,
      systemSource: null, activePostingId: null, effectiveNetPaid: 0, postedOn: null, voucherDate: "2026-09-02",
      sourceEventDate: "2026-09-01", makerUserId: null, flowOwnership: { state: "ready", value: { owner: null, verified: true } },
      postingEvidence: { state: "ready", value: { activePostingId: null, effectiveNetPaid: 0, postedOn: null } },
      notes: null, attachments: [], actionReadiness: { state: "loading" }, ...patch,
    } },
  };
}
const rows: SettlementRow[] = [source, voucher("review", { reviewState: "CHANGES_REQUESTED" }), voucher("pending"), voucher("paid", {
  approvalStatus: "APPROVED", postingStatus: "POSTED", activePostingId: "posting", effectiveNetPaid: 2_000_000,
  postedOn: "2026-09-05", postingEvidence: { state: "ready", value: { activePostingId: "posting", effectiveNetPaid: 2_000_000, postedOn: "2026-09-05" } },
})];
const props = { rows, period: "2026-09", buildings: [{ id: "building", name: "417LVT" }], complete: true, onSelect: vi.fn(), onRefresh: vi.fn(), onPeriodChange: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Khoản chi settlement workbench", () => {
  it("keeps old uncreated and review vouchers, opens stable identities without invoking a writer", () => {
    render(<ContractSettlementPayments {...props} />);
    expect(screen.getByText("HD-101 · Chưa lập phiếu")).toBeTruthy();
    expect(screen.queryByText("HD-102 · PC-paid")).toBeNull();
    expect(screen.getByText(/1 khoản tồn kỳ trước/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Xử lý PC-review" }));
    expect(props.onSelect).toHaveBeenLastCalledWith({ kind: "voucher", voucherId: "review" });
    fireEvent.click(screen.getByRole("button", { name: "Xem nguồn HD-101" }));
    expect(props.onSelect).toHaveBeenLastCalledWith({ kind: "source", sourceRef: source.sourceRef });
  });

  it("switches 3/4 cards and filters pending separately from review", () => {
    render(<ContractSettlementPayments {...props} />);
    expect(screen.getAllByTestId("settlement-stat")).toHaveLength(3);
    fireEvent.click(screen.getByRole("checkbox", { name: "Gộp Chờ duyệt và Chi" }));
    expect(screen.getAllByTestId("settlement-stat")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /^Chờ duyệt / }));
    expect(screen.getByText("HD-102 · PC-pending")).toBeTruthy();
    expect(screen.queryByText("HD-102 · PC-review")).toBeNull();
  });

  it("searches Vietnamese names without accents and computes footer on the full filtered set", () => {
    render(<ContractSettlementPayments {...props} />);
    fireEvent.change(screen.getByPlaceholderText("Tìm phòng, khách, hợp đồng, phiếu…"), { target: { value: "nguyen anh" } });
    expect(screen.getByText("HD-101 · Chưa lập phiếu")).toBeTruthy();
    expect(screen.queryByText("HD-102 · PC-review")).toBeNull();
    expect(screen.getByText("1 hồ sơ chưa lập phiếu")).toBeTruthy();
    expect(screen.getByText(/Tổng trên phiếu: 0/)).toBeTruthy();
  });

  it("labels partial sums and preserves visible identities on error", () => {
    const onRefresh = vi.fn();
    render(<ContractSettlementPayments {...props} complete={false} error="Không tải đủ dữ liệu" onRefresh={onRefresh} />);
    expect(screen.getByRole("alert").textContent).toContain("Không tải đủ dữ liệu");
    expect(screen.getByText(/Tạm tính trên 3 dòng/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("HD-102 · PC-review")).toBeTruthy();
  });

  it("keeps unreadable vouchers as vouchers and never offers source creation", () => {
    const unavailable: SettlementVoucherRow = { ...voucher("hidden"), snapshot: { state: "unavailable", reason: "DETAIL_DENIED" } };
    render(<ContractSettlementPayments {...props} rows={[unavailable]} />);
    expect(screen.getByText("Chưa đọc được")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Xử lý PC-hidden" }));
    expect(props.onSelect).toHaveBeenCalledWith({ kind: "voucher", voucherId: "hidden" });
    expect(screen.queryByText("Lập phiếu chờ duyệt")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Phạm vi kỳ" }), { target: { value: "2026-09" } });
    expect(screen.getByText("Chưa đọc được")).toBeTruthy();
  });

  it("paginates display only, totals every matching row and selects by voucher ID", () => {
    const many = Array.from({ length: 1001 }, (_, index) => voucher(`item-${index}`));
    render(<ContractSettlementPayments {...props} rows={many} />);
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("Tổng trên phiếu: 2.002.000.000đ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sau" }));
    fireEvent.click(screen.getByRole("button", { name: "Xử lý PC-item-50" }));
    expect(props.onSelect).toHaveBeenLastCalledWith({ kind: "voucher", voucherId: "item-50" });
  });

  it("uses posting date explicitly when inspecting payments within a period", () => {
    const paid = voucher("old-signed", { ...((rows[3] as SettlementVoucherRow).snapshot.state === "ready" ? (rows[3] as SettlementVoucherRow & { snapshot: { state: "ready"; value: VoucherSnapshot } }).snapshot.value : {}), id: "old-signed", code: "PC-old-signed", sourceEventDate: "2026-08-01" });
    render(<ContractSettlementPayments {...props} rows={[paid]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Đã chi / }));
    fireEvent.change(screen.getByRole("combobox", { name: "Phạm vi kỳ" }), { target: { value: "2026-09" } });
    expect(screen.queryByText("HD-102 · PC-old-signed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bộ lọc" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Theo ngày" }), { target: { value: "posting" } });
    expect(screen.getByText("HD-102 · PC-old-signed")).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("Đã chi")).toBeTruthy();
  });
});
