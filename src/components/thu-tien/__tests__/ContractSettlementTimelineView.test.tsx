// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContractSettlementTimelineView, type SettlementTimelineLaneView } from "../ContractSettlementTimelineView";

function lane(id: string, role: SettlementTimelineLaneView["role"]): SettlementTimelineLaneView {
  return { id, role, code: `HD-${id}`, customer: "Khách mẫu", status: "Đã thanh lý", steps: [
    { label: "Ký hợp đồng", value: "01/09/2026", detail: "Ngày ký đã xác minh" },
    { label: "Cọc thực thu", value: "Chưa xác minh", detail: "Chưa đọc được chi tiết phiếu gộp" },
    { label: "Tiền khác đã thu", value: "0đ", detail: "Đã xác minh theo ghi sổ" },
    { label: "Thanh lý / hiện tại", value: "Chưa xác minh", detail: "Chưa có hồ sơ thanh lý" },
  ] };
}
afterEach(cleanup);
describe("Contract settlement timeline presentation", () => {
  it("always retains previous, target and latest contract while offering full intermediate history", () => {
    const lanes = [lane("previous", "previous"), lane("target", "target"), lane("next1", "following"), lane("next2", "following"), lane("latest", "current")];
    render(<ContractSettlementTimelineView lanes={lanes} hint="Theo lịch sử cư trú đã xác minh" />);
    for (const id of ["previous", "target", "latest"]) expect(screen.getByText(`HD-${id}`)).toBeTruthy();
    expect(screen.queryByText("HD-next1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Xem thêm 2 hợp đồng" }));
    expect(screen.getByText("HD-next1")).toBeTruthy();
    expect(screen.getByText("HD-next2")).toBeTruthy();
    expect(screen.getAllByText("Chưa xác minh")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "HD-target" })).toBeNull();
  });
  it("keeps chronology warning and missing history distinct from an empty verified history", () => {
    const view = render(<ContractSettlementTimelineView lanes={[]} hint="Chỉ đối chiếu" loading />);
    expect(screen.getByRole("status").textContent).toContain("Đang tải");
    view.rerender(<ContractSettlementTimelineView lanes={[]} hint="Chỉ đối chiếu" error="Chưa đủ quyền đọc lịch sử phòng" onRetry={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("Chưa đủ quyền");
    expect(screen.getByRole("button", { name: "Tải lại vòng đời" })).toBeTruthy();
    view.rerender(<ContractSettlementTimelineView lanes={[lane("target", "target")]} hint="Chỉ đối chiếu" warning="Các giai đoạn cư trú bị chồng lấn; chưa xác định được hợp đồng liền trước." />);
    expect(screen.getByRole("alert").textContent).toContain("chồng lấn");
    expect(screen.getByText("HD-target")).toBeTruthy();
  });
});
