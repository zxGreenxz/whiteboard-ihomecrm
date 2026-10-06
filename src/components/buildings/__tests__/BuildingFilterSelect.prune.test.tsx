// @vitest-environment jsdom
// Báo lỗi 06/10/2026: ô lọc giữ một toà mà danh sách không có ⇒ trang lọc theo toà
// vô hình, số liệu về 0 trong khi ô ghi "Tất cả toà nhà".
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  useBuildings: vi.fn((): { data?: { id: string; name: string }[] } => ({ data: undefined })),
}));

vi.mock("@/hooks/useBuildings", () => ({ useBuildings: harness.useBuildings }));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: (): null => null }));

import { BuildingFilterSelect, withoutUnknownBuildings } from "../BuildingFilterSelect";

const TOA = [
  { id: "b1", name: "102LVT" },
  { id: "b2", name: "1392QT" },
];

afterEach(() => {
  cleanup();
  harness.useBuildings.mockReset();
  harness.useBuildings.mockReturnValue({ data: undefined });
});

describe("withoutUnknownBuildings", () => {
  const ids = new Set(["b1", "b2"]);

  it("bỏ toà không có trong danh sách", () => {
    expect(withoutUnknownBuildings(["x"], ids)).toEqual([]);
    expect(withoutUnknownBuildings(["b1", "x"], ids)).toEqual(["b1"]);
  });

  it("không đổi gì khi mọi toà đều có, hoặc đang lọc tất cả", () => {
    expect(withoutUnknownBuildings(["b1"], ids)).toBeNull();
    expect(withoutUnknownBuildings([], ids)).toBeNull();
  });

  it("danh sách rỗng coi như chưa về — giữ lựa chọn đang khôi phục", () => {
    expect(withoutUnknownBuildings(["b1"], new Set())).toBeNull();
  });
});

describe("BuildingFilterSelect bỏ toà không còn thấy", () => {
  it("danh sách truyền vào đã về mà thiếu toà đang lọc ⇒ về Tất cả", () => {
    const onChange = vi.fn();
    render(<BuildingFilterSelect value={["toa-cua-tai-khoan-truoc"]} onChange={onChange} buildings={TOA} />);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("danh sách tự tải cũng áp dụng", () => {
    harness.useBuildings.mockReturnValue({ data: TOA });
    const onChange = vi.fn();
    render(<BuildingFilterSelect value={["x"]} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("danh sách chưa về thì giữ lựa chọn đang khôi phục (F5 không mất toà đã chọn)", () => {
    const onChange = vi.fn();
    const view = render(<BuildingFilterSelect value={["b1"]} onChange={onChange} buildings={[]} />);
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<BuildingFilterSelect value={["b1"]} onChange={onChange} buildings={TOA} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("trang không nhận giá trị đã sửa cũng không bị gọi lặp", () => {
    const onChange = vi.fn();
    const view = render(<BuildingFilterSelect value={["x"]} onChange={onChange} buildings={TOA} />);
    view.rerender(<BuildingFilterSelect value={["x"]} onChange={onChange} buildings={[...TOA]} />);
    view.rerender(<BuildingFilterSelect value={["x"]} onChange={() => onChange()} buildings={TOA} />);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("pruneUnknown={false} để trang tự xử lý (báo cáo Hiệu quả kinh doanh fail-closed)", () => {
    const onChange = vi.fn();
    render(<BuildingFilterSelect value={["x"]} onChange={onChange} buildings={TOA} pruneUnknown={false} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
