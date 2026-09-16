// @vitest-environment jsdom
//
// Bảng Căn hộ: danh sách dài chỉ render một cửa sổ dòng; các thao tác trên
// dòng (Sửa / Xoá / bật-tắt hoạt động) vẫn gọi đúng callback với đúng phòng.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demDongTrongBang, giaLapKichThuocKhungCuon } from "@/components/ui/__tests__/giaLapKichThuoc";
import type { RoomWithRelations } from "@/types/room";

const { default: RoomListTable } = await import("../RoomListTable");

function phong(i: number): RoomWithRelations {
  return {
    id: `p-${i}`,
    building_id: "b1",
    name: `P.${i}`,
    code: null,
    floor: (i % 10) + 1,
    status: i % 2 === 0 ? "AVAILABLE" : "OCCUPIED",
    area: 25,
    max_occupants: 2,
    rent_price: 3_000_000,
    deposit_amount: 3_000_000,
    description: null,
    images: null,
    amenities: null,
    invoice_template_id: null,
    lease_template_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    building: { id: "b1", name: "Toà A", code: null },
  };
}

giaLapKichThuocKhungCuon();
afterEach(() => cleanup());

describe("RoomListTable · danh sách dài", () => {
  it("500 phòng → DOM chỉ chứa một cửa sổ nhỏ dòng", () => {
    const rooms = Array.from({ length: 500 }, (_, i) => phong(i));
    const { container } = render(
      <RoomListTable rooms={rooms} onEdit={vi.fn()} onDelete={vi.fn()} onToggleStatus={vi.fn()} />,
    );
    const soDong = demDongTrongBang(container);
    // eslint-disable-next-line no-console
    console.log(`[đo DOM] RoomListTable 500 phòng → ${soDong} <tr> trong tbody`);
    expect(soDong, `tbody đang chứa ${soDong} dòng`).toBeLessThan(50);
    expect(soDong).toBeGreaterThan(0);
  });

  it("dưới ngưỡng (20 phòng) → render đủ 20 dòng", () => {
    const rooms = Array.from({ length: 20 }, (_, i) => phong(i));
    const { container } = render(
      <RoomListTable rooms={rooms} onEdit={vi.fn()} onDelete={vi.fn()} onToggleStatus={vi.fn()} />,
    );
    expect(demDongTrongBang(container)).toBe(20);
  });

  it("Sửa / Xoá / công tắc gọi đúng callback với đúng phòng", () => {
    const rooms = Array.from({ length: 500 }, (_, i) => phong(i));
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onToggleStatus = vi.fn();
    render(<RoomListTable rooms={rooms} onEdit={onEdit} onDelete={onDelete} onToggleStatus={onToggleStatus} />);

    fireEvent.click(screen.getAllByTitle("Sửa")[0]!);
    expect(onEdit).toHaveBeenCalledWith(rooms[0]);

    fireEvent.click(screen.getAllByTitle("Xoá")[1]!);
    expect(onDelete).toHaveBeenCalledWith(rooms[1]);

    // P.0 đang AVAILABLE (checked) → bấm là tắt.
    fireEvent.click(screen.getAllByRole("switch")[0]!);
    expect(onToggleStatus).toHaveBeenCalledWith("p-0", false);
  });
});
