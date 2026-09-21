// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractSettlementEvents, type SettlementEventView } from "../ContractSettlementEvents";

const event = (id: string, patch: Partial<SettlementEventView> = {}): SettlementEventView => ({
  id, type: "renew", buildingId: "building", roomName: "204", customerName: "Nguyễn Ánh",
  sourceCode: "HĐ-101", businessDate: "2026-09-10", origin: "contract", staffName: "Sale A",
  links: { state: "ready", values: [] }, ...patch,
});
const props = { period: "2026-09", buildings: [{ id: "building", name: "417LVT" }], complete: true,
  onSelect: vi.fn(), onRefresh: vi.fn(), onPeriodChange: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Biến động presentation", () => {
  it("opens and resets to the selected month while all periods remains an explicit option", () => {
    render(<ContractSettlementEvents {...props} rows={[
      event("current"), event("old", { businessDate: "2026-08-10" }),
    ]} />);
    expect(screen.getByRole("button", { name: "Xem hồ sơ current" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Xem hồ sơ old" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gia hạn 1 lượt biến động" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Phạm vi kỳ"), { target: { value: "all" } });
    expect(screen.getByRole("button", { name: "Xem hồ sơ old" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gia hạn 2 lượt biến động" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bộ lọc" }));
    fireEvent.click(screen.getByRole("button", { name: "Bỏ bộ lọc" }));
    expect(screen.queryByRole("button", { name: "Xem hồ sơ old" })).toBeNull();
    expect((screen.getByLabelText("Phạm vi kỳ") as HTMLSelectElement).value).toBe("2026-09");
  });
  it("keeps unknown-date events reviewable without counting them in a confirmed monthly card", () => {
    const rows = [event("renewal"), event("undated-signing", { type: "sign", businessDate: null })];
    const view = render(<ContractSettlementEvents {...props} rows={rows} />);
    const signingCard = screen.getByRole("button", { name: /^Ký mới .*lượt biến động/ });
    expect(within(signingCard).getByText("0")).toBeTruthy();
    expect(within(signingCard).getByText(/1 chưa rõ ngày/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Xem hồ sơ undated-signing" })).toBeTruthy();
    expect(screen.getAllByText("1 lượt trong kỳ · 1 lượt chưa rõ ngày")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Gia hạn 1 lượt biến động" }));
    expect(screen.queryByRole("button", { name: "Xem hồ sơ undated-signing" })).toBeNull();
    expect(screen.getByText(/1 biến động chưa rõ ngày/)).toBeTruthy();
    view.rerender(<ContractSettlementEvents {...props} rows={rows} fetching />);
    expect(screen.queryByRole("button", { name: "Xem hồ sơ undated-signing" })).toBeNull();
    expect(screen.getByText(/1 biến động chưa rõ ngày/)).toBeTruthy();
    fireEvent.click(signingCard);
    fireEvent.click(screen.getByRole("button", { name: "Xem hồ sơ undated-signing" }));
    expect(props.onSelect).toHaveBeenLastCalledWith("undated-signing");
    fireEvent.change(screen.getByLabelText("Phạm vi kỳ"), { target: { value: "all" } });
    expect(within(signingCard).getByText("1")).toBeTruthy();
    expect(within(signingCard).queryByText(/chưa tính vào kỳ/)).toBeNull();
  });
  it("counts each renewal event in the full set and retains its source identity across display pages", () => {
    const rows = Array.from({ length: 1001 }, (_, i) => event(`extension:${i}`, { sourceCode: `HĐ-${i}` }));
    render(<ContractSettlementEvents {...props} rows={rows} />);
    expect(screen.getAllByTestId("event-stat")).toHaveLength(5);
    expect(within(screen.getByRole("button", { name: "Gia hạn 1001 lượt biến động" })).getByText("1001")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    fireEvent.click(screen.getByRole("button", { name: "Sau" }));
    fireEvent.click(screen.getByRole("button", { name: "Xem hồ sơ extension:50" }));
    expect(props.onSelect).toHaveBeenLastCalledWith("extension:50");
    expect(screen.queryByRole("button", { name: /Duyệt|Chuyển chờ duyệt|Lập phiếu/ })).toBeNull();
  });
  it("filters event types and Vietnamese search while distinguishing missing links from no expense", () => {
    render(<ContractSettlementEvents {...props} rows={[
      event("extension:a"), event("extension:b", { type: "sign", links: { state: "unavailable", reason: "Chưa đọc được khoản chi liên quan" } }),
      event("termination:c", { type: "terminate", customerName: "Khách khác" }),
    ]} />);
    expect(screen.getAllByText("Không phát sinh chi")).toHaveLength(2);
    expect(screen.getByText("Chưa đọc được khoản chi liên quan")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Tìm biến động" }), { target: { value: "nguyen anh" } });
    expect(screen.getByText("2 lượt biến động")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Gia hạn 1 lượt biến động" }));
    expect(screen.queryByRole("button", { name: "Xem hồ sơ extension:b" })).toBeNull();
    expect(screen.getByRole("button", { name: "Xem hồ sơ extension:a" })).toBeTruthy();
  });
  it("keeps unknown dates visible with an explicit notice and preserves loaded rows on refresh failure", () => {
    render(<ContractSettlementEvents {...props} complete={false} error="Không tải lại được biến động" rows={[
      event("unknown", { businessDate: null }), event("old", { businessDate: "2026-08-10" }),
    ]} />);
    fireEvent.change(screen.getByLabelText("Phạm vi kỳ"), { target: { value: "2026-09" } });
    expect(screen.getByRole("button", { name: "Xem hồ sơ unknown" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Xem hồ sơ old" })).toBeNull();
    expect(screen.getByText(/1 biến động chưa rõ ngày/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Không tải lại được biến động");
    expect(screen.getByText(/Tạm tính trên 1 lượt/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });
});
