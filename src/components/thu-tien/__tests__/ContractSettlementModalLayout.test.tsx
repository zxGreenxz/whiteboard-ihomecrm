// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractSettlementModalLayout } from "../ContractSettlementModalLayout";

const props = {
  open: true, onClose: vi.fn(), kindLabel: "Hoàn khách", roomLabel: "417LVT · 101",
  codeLine: "HĐ-nguồn · PC-nguồn", subjectLabel: "Đang xử lý phiếu PC-nguồn",
  metadata: <span>Cần rà soát</span>, timeline: <button>HĐ hiện tại để đối chiếu</button>,
  children: <p>Ghi chú thanh lý của HĐ-nguồn</p>, aside: <button>Chuyển chờ duyệt</button>,
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Settlement modal shell", () => {
  it("keeps current voucher subject distinct from reference timeline and permits dismissal when idle", () => {
    render(<ContractSettlementModalLayout {...props} />);
    expect(screen.getByRole("dialog", { name: "Hoàn khách / 417LVT · 101" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "HĐ hiện tại để đối chiếu" }));
    expect(screen.getByText("Đang xử lý phiếu PC-nguồn")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Đóng hồ sơ" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it("blocks closing and Escape while the shared host has an unresolved operation", () => {
    const view = render(<ContractSettlementModalLayout {...props} dismissalBlocked />);
    expect((screen.getByRole("button", { name: "Đóng hồ sơ" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Đóng hồ sơ" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("xác minh kết quả");
    view.rerender(<ContractSettlementModalLayout {...props} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
