// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("uses the stable list fallback when the original row disappears", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      const [showRow, setShowRow] = useState(true);
      const fallback = useRef<HTMLButtonElement>(null);
      return <><button ref={fallback}>Khoản chi</button>{showRow && <button onClick={() => setOpen(true)}>Mở phiếu</button>}<ContractSettlementModalLayout {...props} open={open} fallbackFocusRef={fallback} onClose={() => { setShowRow(false); setOpen(false); }} /></>;
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Mở phiếu" });
    opener.focus(); fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Đóng hồ sơ" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Khoản chi" })));
  });
  it("returns keyboard focus to the row that opened the dialog after actual close", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Mở phiếu PC-nguồn</button><ContractSettlementModalLayout {...props} open={open} onClose={() => setOpen(false)} /></>;
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Mở phiếu PC-nguồn" });
    opener.focus(); fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Đóng hồ sơ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
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
